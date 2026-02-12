import Player from "../models/player.model.js";
import Match from "../models/match.model.js";

export async function getAllPlayers(req, res) {
    try {
        const players = await Player.find()
        .populate("CountryTPId")
        .populate("PlaysId")
        
        res.json(players);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createPlayer(req, res) {
    const { player } = req.body;

    const newPlayer = new Player({
        player
    });

    try {
        const savedPlayer = await newPlayer.save();
        res.status(201).json(savedPlayer);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getPlayerById(req, res) {
    try {
        const player = await Player.findById(req.params.id);
        if (!player) return res.status(404).json({ message: "Player not found" });
        res.json(player);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updatePlayer(req, res) {
    try {
        const updatedPlayer = await Player.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedPlayer);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deletePlayer(req, res) {
    try {
        await Player.findByIdAndDelete(req.params.id);
        res.json({ message: "Player deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function getPaginatedPlayers(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;       // Trenutna stranica
        const pageSize = parseInt(req.query.pageSize) || 100; // Broj zapisa po stranici
    
        const totalCount = await Player.countDocuments(); // Ukupan broj zapisa
        const totalPages = Math.ceil(totalCount / pageSize); // Ukupan broj stranica
    
        const players = await Player.find()
          .skip((page - 1) * pageSize)
          .limit(pageSize);
    
        res.status(200).json({
          players,
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

export async function getPlayerWithMatches(req, res) {
    try {
        const playerTPId = parseInt(req.params.id);

        const player = await Player.findOne({ _id: playerTPId });

        if (!player) {
            return res.status(404).json({ message: "Player not found" });
        }

        const matches = await Match.find(
            {
                $or: [
                    { player1TPId: playerTPId },
                    { player2TPId: playerTPId }
                ]
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
        .sort({ dateTime: -1 }) // najnoviji prvi
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

        res.json({
            player,
            matchCount: matches.length,
            matches 
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
}

export async function searchPlayers(req, res) {
    try {
        const query = req.query.q;
        if (!query) return res.json([]);

        const regex = new RegExp(query, "i"); // case-insensitive partial match

        const players = await Player.find({ playerName: { $regex: regex } })
            .limit(10)
            .select("playerName _id");

        res.json(players);
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
}