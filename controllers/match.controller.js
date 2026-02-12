import Match from "../models/match.model.js";
import TournamentEvent from "../models/tournamentEvent.model.js";

export async function getAllMatches(req, res) {
    try {
        const matches = await Match.find()
            .populate("TournamentEventTPId")
            .populate("Player1TPId")
            .populate("Player2TPId")

        res.json(matches);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createMatch(req, res) {
    const { match } = req.body;

    const newMatch = new Match({
        match
    });

    try {
        const savedMatch = await newMatch.save();
        res.status(201).json(savedMatch);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getMatchById(req, res) {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ message: "Match not found" });
        res.json(match);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updateMatch(req, res) {
    try {
        const updatedMatch = await Match.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedMatch);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteMatch(req, res) {
    try {
        await Match.findByIdAndDelete(req.params.id);
        res.json({ message: "Match deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function getMatchesByDate(req, res) {
    try {
        const { date } = req.params;

        // Pretvaranje YYYYMMDD u ISO datume
        const year = date.slice(0, 4);
        const month = date.slice(4, 6);
        const day = date.slice(6, 8);

        const startDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        const endDate = new Date(`${year}-${month}-${day}T23:59:59.999Z`);

        const matches = await Match.find({
            dateTime: { $gte: startDate, $lte: endDate }
        });

        res.json(matches);
    } catch (error) {
        console.error("Error fetching matches by date:", error);
        res.status(500).json({ message: "Server error" });
    }
};

export async function getPaginatedMatches(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;       // Trenutna stranica
        const pageSize = parseInt(req.query.pageSize) || 10; // Broj zapisa po stranici

        const totalCount = await Match.countDocuments(); // Ukupan broj zapisa
        const totalPages = Math.ceil(totalCount / pageSize); // Ukupan broj stranica

        const matches = await Match.find()
            .skip((page - 1) * pageSize)
            .limit(pageSize);

        res.status(200).json({
            matches,
            pagination: {
                totalCount,
                totalPages,
                currentPage: page,
                pageSize,
            },
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function getAllMatchSummaries(req, res) {
    try {
        const matches = await Match.find({}, {
            _id: 1,
            dateTime: 1,
            tournamentEventTPId: 1,
            player1TPId: 1,
            player2TPId: 1,
            result: 1,
            player1Odds: 1,
            player2Odds: 1,
        })
            .populate("TournamentEventTPId")
            .populate("Player1TPId")
            .populate("Player2TPId")

        res.json(matches);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function getPaginatedMatchSummariesByDate(req, res) {
    try {
        const { date } = req.params;

        // Pretvaranje YYYYMMDD u ISO datume
        const year = date.slice(0, 4);
        const month = date.slice(4, 6);
        const day = date.slice(6, 8);

        const startDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        const endDate = new Date(`${year}-${month}-${day}T23:59:59.999Z`);

        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;

        const totalCount = await Match.countDocuments({
            dateTime: { $gte: startDate, $lte: endDate }
        });

        const matches = await Match.find(
            {
                dateTime: { $gte: startDate, $lte: endDate } 
            },
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
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .populate({
                path: "tournamentEventTPId",
                select: "tournamentEventName countryTPId tournamentLevelId tournamentTypeId",
                populate: [
                    {
                        path: "countryTPId",
                        select: "countryShort countryFull",
                    },
                    {
                        path: "tournamentLevelId",
                        select: "tournamentLevel",
                    },
                    {
                        path: "tournamentTypeId",
                        select: "tournamentType",
                    },
                ]
            })
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

        res.status(200).json({
            matches,
            pagination: {
                totalCount,
                totalPages: Math.ceil(totalCount / pageSize),
                currentPage: page,
                pageSize,
            },
        });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function filterMatches(req, res) {
    try {
        const {
            countryId,
            surfaceId,
            tournamentTypeId,
            tournamentLevelId,
            startDate,
            endDate,
            page = 1,
            limit = 20,
        } = req.query;

        const matchQuery = {};

        if (startDate || endDate) {
            matchQuery.dateTime = {};
            if (startDate) matchQuery.dateTime.$gte = new Date(startDate);
            if (endDate) matchQuery.dateTime.$lte = new Date(endDate);
        }

        // Mečevi preko turnira → dohvatimo samo one turnire koji odgovaraju filterima
        const tournamentFilter = {};
        if (countryId) tournamentFilter.countryTPId = parseInt(countryId);
        if (surfaceId) tournamentFilter.surfaceId = parseInt(surfaceId);
        if (tournamentTypeId) tournamentFilter.tournamentTypeId = parseInt(tournamentTypeId);
        if (tournamentLevelId) tournamentFilter.tournamentLevelId = parseInt(tournamentLevelId);

        let tournamentEventIds = [];

        if (Object.keys(tournamentFilter).length > 0) {
            const tournaments = await TournamentEvent.find(tournamentFilter).select("_id");
            tournamentEventIds = tournaments.map(t => t._id);
            matchQuery.tournamentEventTPId = { $in: tournamentEventIds };
        }

        const matches = await Match.find(matchQuery)
            .sort({ dateTime: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .select("matchTPId result resultDetails player1TPId player2TPId dateTime tournamentEventTPId player1Odds player2Odds winProbabilityNN")
            .populate({
                path: "tournamentEventTPId",
                select: "tournamentEventName countryTPId tournamentLevelId tournamentTypeId surfaceId",
                populate: [
                    { path: "countryTPId", select: "countryShort countryFull" },
                    { path: "tournamentLevelId", select: "tournamentLevel" },
                    { path: "tournamentTypeId", select: "tournamentType" },
                    { path: "surfaceId", select: "surface" }
                ]
            })
            .populate({
                path: "player1TPId",
                select: "playerName countryTPId",
                populate: { path: "countryTPId", select: "countryShort countryFull" }
            })
            .populate({
                path: "player2TPId",
                select: "playerName countryTPId",
                populate: { path: "countryTPId", select: "countryShort countryFull" }
            });

        res.json(matches);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
}
