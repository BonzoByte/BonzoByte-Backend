import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import TournamentLevel from "../../models/tournamentLevel.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importTournamentLevels = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "tournamentLevel.csv");

    createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => {
      // Log the raw data object to see its exact structure
      console.log("Raw data:", data);
      
      // Try accessing by both direct property and using bracket notation
      const id = Number(data.tournamentLevelId || data['tournamentLevelId']);
      const tournamentLevel = (data.tournamentLevel || data['tournamentLevel'])?.trim();
      
      console.log(`Parsed values - ID: ${id}, TournamentLevel: ${tournamentLevel}`);
      
      if (!isNaN(id) && tournamentLevel) {
        results.push({ 
          _id: id, 
          tournamentLevel: tournamentLevel
        });
        console.log(`Added entry: _id=${id}, TournamentLevel=${tournamentLevel}`);
      } else {
        console.warn(`No valid data (ID: ${id}, ${tournamentLevel})`);
      }
    })
      .on("end", async () => {
        try {
          console.log(results);
          await TournamentLevel.deleteMany({});
          await TournamentLevel.insertMany(results);
          console.log("✅ TournamentLevels imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });
  } catch (err) {
    console.error("❌ Error importing tournamentLevels:", err);
    disconnect();
  }
};

importTournamentLevels();