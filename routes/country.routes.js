import { Router } from "express";
const router = Router();
import { getAllCountries, createCountry, getCountryById, updateCountry, deleteCountry } from "../controllers/country.controller.js";
import protect, { isUser, isAdmin } from '../middleware/auth.middleware.js';

router.get("/", getAllCountries);
router.post("/", protect, isAdmin, createCountry);
router.get("/:id", getCountryById);
router.put("/:id", protect, isAdmin, updateCountry);
router.delete("/:id", protect, isAdmin, deleteCountry);

export default router;
