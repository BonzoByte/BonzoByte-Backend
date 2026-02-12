import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import Country from "../../models/country.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importCountries = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "country.csv");

    createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        const tpid = Number(data.countryTPId);
        const shortRaw = data.countryShort?.trim();
        const full = data.countryFull?.trim();
      
        const short = shortRaw === "" ? "WLD" : shortRaw;
      
        if (tpid && short && full) {
          results.push({
            _id: tpid,
            countryShort: short,
            countryFull: full
          });
        } else {
          console.warn(`No valid data (TPID: ${tpid}, ${short}, ${full})`);
        }
      })
      .on("end", async () => {
        try {
          await Country.deleteMany({});
          await Country.insertMany(results);
          console.log("✅ Countries imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });
  } catch (err) {
    console.error("❌ Error importing countries:", err);
    disconnect();
  }
};

importCountries();