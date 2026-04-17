require("dotenv").config();

const app = require("./app");
const { startRideReminderScheduler } = require("./services/rideReminderScheduler");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`One Way backend running on ${PORT}`);
  startRideReminderScheduler();
});
