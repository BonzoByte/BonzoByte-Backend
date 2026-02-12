import TournamentLevel from "../models/tournamentLevel.model.js";

export async function getAllTournamentLevels(req, res) {
    try {
        const tournamentLevels = await TournamentLevel.find();
        res.json(tournamentLevels);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createTournamentLevel(req, res) {
    const { tournamentLevel } = req.body;

    const newTournamentLevel = new TournamentLevel({
        tournamentLevel
    });

    try {
        const savedTournamentLevel = await newTournamentLevel.save();
        res.status(201).json(savedTournamentLevel);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getTournamentLevelById(req, res) {
    try {
        const tournamentLevel = await TournamentLevel.findById(req.params.id);
        if (!tournamentLevel) return res.status(404).json({ message: "TournamentLevel not found" });
        res.json(tournamentLevel);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updateTournamentLevel(req, res) {
    try {
        const updatedTournamentLevel = await Plays.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedTournamentLevel);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteTournamentLevel(req, res) {
    try {
        await TournamentLevel.findByIdAndDelete(req.params.id);
        res.json({ message: "TournamentLevel deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}