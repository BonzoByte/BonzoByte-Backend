import { Router } from "express";
const router = Router();
import { getAllTournamentLevels, createTournamentLevel, getTournamentLevelById, updateTournamentLevel, deleteTournamentLevel } from "../controllers/tournamentLevel.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/", getAllTournamentLevels);
router.post("/", protect, isAdmin, createTournamentLevel);
router.get("/:id", getTournamentLevelById);
router.put("/:id", protect, isAdmin, updateTournamentLevel);
router.delete("/:id", protect, isAdmin, deleteTournamentLevel);

export default router;