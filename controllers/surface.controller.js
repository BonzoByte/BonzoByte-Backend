import Surface from "../models/surface.model.js";

export async function getAllSurfaces(req, res) {
    try {
        const surfaces = await Surface.find();
        res.json(surfaces);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function createSurface(req, res) {
    const { surface } = req.body;

    const newSurface = new Surface({
        surface
    });

    try {
        const savedSurface = await newSurface.save();
        res.status(201).json(savedSurface);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getSurfaceById(req, res) {
    try {
        const surface = await Surface.findById(req.params.id);
        if (!surface) return res.status(404).json({ message: "Surface not found" });
        res.json(surface);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updateSurface(req, res) {
    try {
        const updatedSurface = await Plays.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedSurface);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteSurface(req, res) {
    try {
        await Surface.findByIdAndDelete(req.params.id);
        res.json({ message: "Surface deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}