
import mongoose from 'mongoose';

const dailyAircraftSchema = new mongoose.Schema({
    date: {
        type: String,
        required: true
    },

    hex: {
        type: String,
        required: true
    },

    callsign: String,

    firstSeen: {
        type: Date,
        default: Date.now
    },

    lastSeen: {
        type: Date,
        default: Date.now
    },

    maxAltitude: {
        type: Number,
        default: 0
    },

    maxSpeed: {
        type: Number,
        default: 0
    },

    messages: {
        type: Number,
        default: 0
    }
});

// Jeden samolot może mieć jeden wpis dziennie
dailyAircraftSchema.index(
    { date: 1, hex: 1 },
    { unique: true }
);

const DailyAircraft = mongoose.model(
    'DailyAircraft',
    dailyAircraftSchema
);

export default DailyAircraft;
