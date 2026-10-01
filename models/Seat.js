import mongoose from 'mongoose';

const seatSchema = new mongoose.Schema({
  seatId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['AVAILABLE', 'HELD', 'SOLD'], default: 'AVAILABLE' },
  heldBy: { type: String, default: null },
});

export const Seat = mongoose.model('Seat', seatSchema);