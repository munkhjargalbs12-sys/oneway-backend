require("dotenv").config();

console.log("🔑 API KEY:", process.env.GOOGLE_MAPS_API_KEY);

const app = require("./app");

app.listen(3000, () => {
  console.log("🚀 One Way backend running on 3000");
});
