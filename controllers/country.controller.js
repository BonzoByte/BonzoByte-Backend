import Country from "../models/country.model.js";

export const getAllCountries = async (req, res) => {
    try {
      const countries = await Country.find().sort({ countryFull: 1 }); // sortirano po nazivu
      res.status(200).json(countries);
    } catch (err) {
      res.status(500).json({ message: 'Greška prilikom dohvaćanja zemalja.' });
    }
  };

export async function createCountry(req, res) {
    const { countryTPId, countryShort, countryFull } = req.body;

    const newCountry = new Country({
        countryTPId,
        countryShort,
        countryFull
    });

    try {
        const savedCountry = await newCountry.save();
        res.status(201).json(savedCountry);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function getCountryById(req, res) {
    try {
        const country = await Country.findById(req.params.id); // ✅
        if (!country) return res.status(404).json({ message: "Country not found" });
        res.json(country);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

export async function updateCountry(req, res) {
    try {
        const updatedCountry = await Country.findByIdAndUpdate( // ✅
            req.params.id,
            req.body,
            { new: true }
        );
        res.json(updatedCountry);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

export async function deleteCountry(req, res) {
    try {
        await Country.findByIdAndDelete(req.params.id); // ✅
        res.json({ message: "Country deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}
