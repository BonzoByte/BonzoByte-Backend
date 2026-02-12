import { Schema, model } from "mongoose";

const tournamentTypeSchema = new Schema({
  _id: { type: Number, required: true, match: /^[1-9]{1}$/},
  tournamentType: { type: String, required: true, minlength: 3, maxlength: 10 },
});

export default model("TournamentType", tournamentTypeSchema);