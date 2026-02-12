import { Router } from "express";
const router = Router();
import { getAllSurfaces, createSurface, getSurfaceById, updateSurface, deleteSurface } from "../controllers/surface.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/", getAllSurfaces);
router.post("/", protect, isAdmin, createSurface);
router.get("/:id", getSurfaceById);
router.put("/:id", protect, isAdmin, updateSurface);
router.delete("/:id", protect, isAdmin, deleteSurface);

export default router;
