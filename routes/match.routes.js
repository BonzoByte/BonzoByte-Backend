import { Router } from "express";
const router = Router();
import { getAllMatches, createMatch, getMatchById, updateMatch, deleteMatch, getMatchesByDate, getPaginatedMatches, getAllMatchSummaries, getPaginatedMatchSummariesByDate, filterMatches } from "../controllers/match.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/filter", filterMatches);
router.get("/paginated", getPaginatedMatches);
router.get("/", getAllMatches);
router.post("/", protect, isAdmin, createMatch);
router.get("/:id", getMatchById);
router.put("/:id", protect, isAdmin, updateMatch);
router.delete("/:id", protect, isAdmin, deleteMatch);
router.get("/by-date/:date", getMatchesByDate);
router.get("/summaries", getAllMatchSummaries);
router.get("/summaries/by-date/:date", getPaginatedMatchSummariesByDate);

export default router;