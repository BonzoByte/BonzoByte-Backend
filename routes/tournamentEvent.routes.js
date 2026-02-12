import { Router } from "express";
const router = Router();
import { getAllTournamentEvents, createTournamentEvent, updateTournamentEvent, deleteTournamentEvent, getTournamentEventWithMatches, searchTournaments } from "../controllers/tournamentEvent.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/search", searchTournaments);
router.get("/", getAllTournamentEvents);
router.get("/:id/matches", getTournamentEventWithMatches);
router.post("/", protect, isAdmin, createTournamentEvent);
router.put("/:id", protect, isAdmin, updateTournamentEvent);
router.delete("/:id", protect, isAdmin, deleteTournamentEvent);

export default router;