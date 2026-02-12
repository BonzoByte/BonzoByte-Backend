import { Schema, model } from "mongoose";

const tournamentLevelSchema = new Schema({
  _id: { type: Number, required: true, match: /^[1-9]{1}$/},
  tournamentLevel: { type: String, required: true, minlength: 3, maxlength: 22 },
});

export default model("TournamentLevel", tournamentLevelSchema);