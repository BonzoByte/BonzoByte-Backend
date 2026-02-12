import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import TournamentEvent from "../../models/tournamentEvent.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importTournamentEvents = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "tournamentEvent.csv");

    createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        console.log("Raw data:", data);

        const tpid = Number(data.tournamentEventTPId?.trim());
        const tournamentEventName = (data.tournamentEventName)?.trim();
        const country = Number(data.countryTPId?.trim());
        const tournamentEventDate = new Date(data.tournamentEventDate?.trim());
        const tournamentLevel = Number(data.tournamentLevelId?.trim());
        const tournamentType = Number(data.tournamentTypeId?.trim());
        const prize = data.prize?.trim().toUpperCase() === "NULL" ? undefined : Number(data.prize?.trim());
        const surface = Number(data.surfaceId?.trim());

        console.log(`Parsed values - ID: ${tpid}, TournamentEvent: ${tournamentEventName}`);
        console.log("Raw data:", JSON.stringify(data));

        if (!isNaN(tpid) && tournamentEventName) {
          results.push({ 
            _id: tpid, 
            tournamentEventName: tournamentEventName,
            countryTPId: isNaN(country) ? undefined : country,
            tournamentEventDate: tournamentEventDate,
            tournamentLevelId: isNaN(tournamentLevel) ? undefined : tournamentLevel,
            tournamentTypeId: isNaN(tournamentType) ? undefined : tournamentType,
            prize: prize,
            surfaceId: isNaN(surface) ? undefined : surface
          });
        } else {
          console.warn(`No valid data (ID: ${tpid}, ${tournamentEventName})`);
        }
      })
      .on("end", async () => {
        try {
          await TournamentEvent.deleteMany({});
          await TournamentEvent.insertMany(results);
          console.log("✅ TournamentEvents imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });

    // 👉 process.on:
    process.on("exit", () => {
      console.log("Process exiting. Final IDs collected:", results.map(r => r._id));
      const undefinedFields = results.filter(r => 
        r.tournamentLevelId === undefined || 
        r.tournamentTypeId === undefined
      );
      if (undefinedFields.length > 0) {
        console.log("⚠️ Entries with missing required fields:", undefinedFields);
      }
    });

  } catch (err) {
    console.error("❌ Error importing tournamentEvents:", err);
    disconnect();
  }
};

importTournamentEvents();