require("dotenv").config();

console.log("🔑 API KEY:", process.env.GOOGLE_MAPS_API_KEY);

const app = require("./app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 One Way backend running on ${PORT}`);
});
