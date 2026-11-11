import { Router } from "express";
const router = Router();
import { getAllPlayers, createPlayer, getPlayerById, updatePlayer, deletePlayer, getPaginatedPlayers, getPlayerWithMatches, searchPlayers } from "../controllers/player.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/search", searchPlayers);
router.get("/paginated", getPaginatedPlayers);
router.get("/", getAllPlayers);
router.post("/", protect, isAdmin, createPlayer);
router.get("/:id", getPlayerById);
router.put("/:id", protect, isAdmin, updatePlayer);
router.delete("/:id", protect, isAdmin, deletePlayer);
router.get("/:id/matches", getPlayerWithMatches );

export default router;