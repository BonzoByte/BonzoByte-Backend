import Pick from "../models/pick.model.js";
import MatchActive from "../models/matchActive.model.js";

export const addPick = async (req, res) => {
  const { matchTPId } = req.params;
  const { pickedPlayerTPId } = req.body;

  try {
    const existingPick = await Pick.findOne({ userId: req.user._id, matchTPId });
    if (existingPick) {
      return res.status(400).json({ message: "You have already made a pick for this match." });
    }

    const match = await MatchActive.findById(matchTPId);
    if (!match) return res.status(404).json({ message: "Match not found or already finished." });

    const odds = pickedPlayerTPId === match.player1TPId ? match.player1Odds
                : pickedPlayerTPId === match.player2TPId ? match.player2Odds
                : null;

    if (odds === null) {
      return res.status(400).json({ message: "Picked player not part of this match." });
    }

    const pick = await Pick.create({
      userId: req.user._id,
      matchTPId,
      pickedPlayerTPId,
      oddsAtPickTime: odds
    });

    res.status(201).json(pick);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const removePick = async (req, res) => {
  const { matchTPId } = req.params;

  try {
    const deleted = await Pick.findOneAndDelete({ userId: req.user._id, matchTPId });
    if (!deleted) {
      return res.status(404).json({ message: "No pick found to delete." });
    }
    res.json({ message: "Pick deleted successfully." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const getMyPicks = async (req, res) => {
  try {
    const picks = await Pick.find({ userId: req.user._id });
    res.json(picks);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
