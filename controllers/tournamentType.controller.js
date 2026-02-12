import TournamentType from "../models/tournamentType.model.js";

export async function getAllTournamentTypes(req, res) {
    try {
        const tournamentTypes = await TournamentType.find();
        res.json(tournamentTypes);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createTournamentType(req, res) {
    const { tournamentType } = req.body;

    const newTournamentType = new TournamentType({
        tournamentType
    });

    try {
        const savedTournamentType = await newTournamentType.save();
        res.status(201).json(savedTournamentType);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getTournamentTypeById(req, res) {
    try {
        const tournamentType = await TournamentType.findById(req.params.id);
        if (!tournamentType) return res.status(404).json({ message: "TournamentType not found" });
        res.json(tournamentType);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updateTournamentType(req, res) {
    try {
        const updatedTournamentType = await Plays.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedTournamentType);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteTournamentType(req, res) {
    try {
        await TournamentType.findByIdAndDelete(req.params.id);
        res.json({ message: "TournamentType deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}