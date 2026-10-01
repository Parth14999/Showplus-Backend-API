import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Razorpay from 'razorpay';

import { User } from './models/User.js';
import { Seat } from './models/Seat.js';
import Booking from './models/Booking.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] }
});

// Connect MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('🍃 MongoDB connected successfully!'))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// REST API ENDPOINTS
// ==========================================

// 1. Signup Endpoint
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    
    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.status(201).json({ user: { name: user.name, email: user.email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ user: { name: user.name, email: user.email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Seats
app.get('/api/seats', async (req, res) => {
  try {
    const dbSeats = await Seat.find();
    const seatMap = {};
    dbSeats.forEach(s => { seatMap[s.seatId] = s.status; });
    res.json(seatMap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Create Booking
app.post('/api/bookings', async (req, res) => {
  try {
    const { userEmail, seats, totalAmount, movieTitle, theater, showtime, paymentId } = req.body;

    const booking = await Booking.create({
      userEmail,
      seats,
      totalAmount,
      movieTitle,
      theater,
      showtime,
      paymentId
    });

    // Mark seats as occupied in Seat collection
    if (seats && Array.isArray(seats)) {
      for (const seatId of seats) {
        await Seat.findOneAndUpdate(
          { seatId },
          { status: 'OCCUPIED' },
          { upsert: true }
        );
      }
      // Broadcast seat updates to all connected clients
      io.emit('seats-updated', seats);
    }

    res.status(201).json({ booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Fetch User Bookings
app.get('/api/bookings/:email', async (req, res) => {
  try {
    const userBookings = await Booking.find({ userEmail: req.params.email }).sort({ createdAt: -1 });
    res.json({ success: true, bookings: userBookings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin Dashboard Stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalBookings = await Booking.find();
    const totalUsersCount = await User.countDocuments();

    const totalRevenue = totalBookings.reduce((sum, item) => sum + (item.totalAmount || 0), 0);

    const soldSeatsCount = totalBookings.reduce((count, booking) => {
      if (Array.isArray(booking.seats)) {
        return count + booking.seats.length;
      }
      return count + (booking.seats ? 1 : 0);
    }, 0);

    const TOTAL_CAPACITY = 48;
    const occupancyRate = ((soldSeatsCount / TOTAL_CAPACITY) * 100).toFixed(1);

    res.json({
      totalRevenue,
      ticketsSold: soldSeatsCount,
      totalCapacity: TOTAL_CAPACITY,
      occupancyRate,
      totalUsers: totalUsersCount,
      recentBookings: totalBookings.slice(-5).reverse()
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 7. Cancel Booking & Refund Route
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { bookingId, paymentId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'Booking ID is required' });
    }

    // 1. Fetch booking to release reserved seats
    const booking = await Booking.findById(bookingId);
    if (booking && booking.seats) {
      // Free seats in DB
      await Seat.deleteMany({ seatId: { $in: booking.seats } });
      io.emit('seats-freed', booking.seats);
    }

    // 2. Initiate Razorpay Refund (if paymentId provided)
    let refundResult = null;
    if (paymentId && !paymentId.startsWith('order_demo')) {
      try {
        refundResult = await razorpay.payments.refund(paymentId, {
          speed: 'normal',
          notes: { reason: 'User requested cancellation' }
        });
      } catch (rzpErr) {
        console.error('Razorpay Refund Processing Error:', rzpErr.description || rzpErr);
      }
    }

    // 3. Delete booking from DB
    await Booking.findByIdAndDelete(bookingId);

    res.status(200).json({
      success: true,
      message: 'Ticket cancelled successfully and refund initiated!',
      refundId: refundResult ? refundResult.id : 'REFUND_MOCK_SUCCESS'
    });

  } catch (error) {
    console.error('Cancellation Error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel ticket' });
  }
});

// ==========================================
// 💳 RAZORPAY PAYMENT GATEWAY
// ==========================================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TPmgyrf1y0WrqK',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'zQg8NKTneFB3dWpQe7T4RMg8',
});

app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: (amount || 500) * 100,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Razorpay Error:', error);
    res.status(500).json({ success: false, message: 'Payment Order Failed' });
  }
});

// ==========================================
// SOCKET.IO REAL-TIME ENGINE
// ==========================================
io.on('connection', async (socket) => {
  console.log(`⚡ Socket connected: ${socket.id}`);

  try {
    const dbSeats = await Seat.find();
    const seatMap = {};
    dbSeats.forEach(s => { seatMap[s.seatId] = s.status; });
    socket.emit('seat-state', seatMap);
  } catch (err) {
    console.error('Error fetching seats on connect:', err);
  }

  socket.on('update-seat', async ({ seatId, status }) => {
    try {
      if (status === 'AVAILABLE') {
        await Seat.deleteOne({ seatId });
      } else {
        await Seat.findOneAndUpdate({ seatId }, { status }, { upsert: true });
      }
      io.emit('seat-updated', { seatId, status });
    } catch (err) {
      console.error('Error updating seat:', err);
    }
  });
});

// ==========================================
// SERVER LISTEN (HUMESHA AKHRI MEIN)
// ==========================================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
});