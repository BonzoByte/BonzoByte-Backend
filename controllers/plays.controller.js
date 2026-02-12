import Plays from "../models/plays.model.js";

export async function getAllPlays(req, res) {
    try {
        const plays = await Plays.find();
        res.json(plays);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createPlays(req, res) {
    const { _id, plays } = req.body;

    const newPlays = new Plays({
        _id,
        plays
    });

    try {
        const savedPlays = await newPlays.save();
        res.status(201).json(savedPlays);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getPlaysById(req, res) {
    try {
        const plays = await Plays.findById(req.params.id);
        if (!plays) return res.status(404).json({ message: "Plays not found" });
        res.json(plays);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updatePlays(req, res) {
    try {
        const updatedPlays = await Plays.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedPlays);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deletePlays(req, res) {
    try {
        await Plays.findByIdAndDelete(req.params.id);
        res.json({ message: "Plays deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}