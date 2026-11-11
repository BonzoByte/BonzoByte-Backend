import { Router } from "express";
const router = Router();
import { getAllTournamentTypes, createTournamentType, getTournamentTypeById, updateTournamentType, deleteTournamentType } from "../controllers/tournamentType.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/", getAllTournamentTypes);
router.post("/", protect, isAdmin, createTournamentType);
router.get("/:id", getTournamentTypeById);
router.put("/:id", protect, isAdmin, updateTournamentType);
router.delete("/:id", protect, isAdmin, deleteTournamentType);

export default router;