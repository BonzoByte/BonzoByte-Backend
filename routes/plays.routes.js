import { Router } from "express";
const router = Router();
import { getAllPlays, createPlays, getPlaysById, updatePlays, deletePlays } from "../controllers/plays.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/", getAllPlays);
router.post("/", protect, isAdmin, createPlays);
router.get("/:id", getPlaysById);
router.put("/:id", protect, isAdmin, updatePlays);
router.delete("/:id", protect, isAdmin, deletePlays);

export default router;
