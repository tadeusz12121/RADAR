
import mongoose from 'mongoose';

const trackPointSchema = new mongoose.Schema({
    at: {
        type: Date,
        required: true
    },
    lat: {
        type: Number,
        required: true
    },
    lon: {
        type: Number,
        required: true
    },
    altitude: Number,
    speed: Number,
    heading: Number,
    verticalRate: Number,
    data: mongoose.Schema.Types.Mixed
}, { _id: false });

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
    registration: String,
    aircraftType: String,
    category: String,
    squawk: String,
    emergency: String,
    lastLatitude: Number,
    lastLongitude: Number,
    lastAltitude: Number,
    lastSpeed: Number,
    lastHeading: Number,
    verticalRate: Number,
    latestData: mongoose.Schema.Types.Mixed,
    trackPoints: {
        type: [trackPointSchema],
        default: []
    },

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
