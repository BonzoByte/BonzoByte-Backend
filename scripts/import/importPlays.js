import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import Plays from "../../models/plays.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importPlays = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "plays.csv");

    createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => {
      // Log the raw data object to see its exact structure
      console.log("Raw data:", data);
      
      // Try accessing by both direct property and using bracket notation
      const id = Number(data.playsId || data['playsId']);
      const plays = (data.plays || data['plays'])?.trim();
      
      console.log(`Parsed values - ID: ${id}, Plays: ${plays}`);
      
      if (!isNaN(id) && plays) {
        results.push({ 
          _id: id, 
          plays: plays
        });
        console.log(`Added entry: _id=${id}, plays=${plays}`);
      } else {
        console.warn(`No valid data (ID: ${id}, ${plays})`);
      }
    })
      .on("end", async () => {
        try {
          await Plays.deleteMany({});
          await Plays.insertMany(results);
          console.log("✅ Plays imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });
  } catch (err) {
    console.error("❌ Error importing plays:", err);
    disconnect();
  }
};

importPlays();