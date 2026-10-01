import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  seats: { type: Array, required: true },
  totalAmount: { type: Number, required: true },
  movieTitle: { type: String, default: 'Neon Pulse World Tour 2026' },
  theater: { type: String, default: 'PVR ICON' },
  showtime: { type: String, default: '07:00 PM' },
  createdAt: { type: Date, default: Date.now },
});

const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);

export default Booking;