import TournamentEvent from "../models/tournamentEvent.model.js";
import Match from "../models/match.model.js";

export async function getAllTournamentEvents(req, res) {
    try {
        const tournamentEvents = await TournamentEvent.find()
        .populate("countryTPId")
        .populate("tournamentLevelId")
        .populate("tournamentTypeId")
        .populate("surfaceId");
        
        res.json(tournamentEvents);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createTournamentEvent(req, res) {
    const { tournamentEvent } = req.body;

    const newTournamentEvent = new TournamentEvent({
        tournamentEvent
    });

    try {
        const savedTournamentEvent = await newTournamentEvent.save();
        res.status(201).json(savedTournamentEvent);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function updateTournamentEvent(req, res) {
    try {
        const updatedTournamentEvent = await Plays.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedTournamentEvent);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteTournamentEvent(req, res) {
    try {
        await TournamentEvent.findByIdAndDelete(req.params.id);
        res.json({ message: "TournamentEvent deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function getTournamentEventWithMatches(req, res) {
    try {
        const tournamentTPId = parseInt(req.params.id);

        // Dohvati turnir
        const tournamentEvent = await TournamentEvent.findOne({ _id: tournamentTPId })
            .populate("countryTPId", "countryShort countryFull")
            .populate("tournamentLevelId", "tournamentLevel")
            .populate("tournamentTypeId", "tournamentType");

        if (!tournamentEvent) {
            return res.status(404).json({ message: "TournamentEvent not found" });
        }

        // Dohvati sve mečeve povezane s turnirom
        const matches = await Match.find(
            { tournamentEventTPId: tournamentTPId },
            {
                _id: 1,
                dateTime: 1,
                tournamentEventTPId: 1,
                player1TPId: 1,
                player2TPId: 1,
                result: 1,
                player1Odds: 1,
                player2Odds: 1,
                winProbabilityNN: 1
            }
        )
        .sort({ dateTime: 1 }) // kronološki po danima meča
        .populate({
            path: "player1TPId",
            select: "playerName countryTPId",
            populate: {
                path: "countryTPId",
                select: "countryShort countryFull",
            }
        })
        .populate({
            path: "player2TPId",
            select: "playerName countryTPId",
            populate: {
                path: "countryTPId",
                select: "countryShort countryFull",
            }
        });

        res.json({
            tournamentEvent,
            matchCount: matches.length,
            matches
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
}

export async function searchTournaments(req, res) {
    try {
        const query = req.query.q;
        if (!query) return res.json([]);

        const regex = new RegExp(query, "i");

        const tournaments = await TournamentEvent.find({ tournamentEventName: { $regex: regex } })
            .limit(10)
            .select("tournamentEventName _id");

        res.json(tournaments);
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
}