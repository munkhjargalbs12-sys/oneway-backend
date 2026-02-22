



exports.computeRoute = async (req, res) => {
  console.log("🔥 /route HIT", req.body);

  try {
    const { start, end } = req.body;

    if (!start?.lat || !start?.lng || !end?.lat || !end?.lng) {
      return res.status(400).json({ error: "Invalid start or end" });
    }

    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: start.lat,
                longitude: start.lng,
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: end.lat,
                longitude: end.lng,
              },
            },
          },
          travelMode: "DRIVE",
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ Google API error:", text);
      return res.status(500).json({ error: "Google Routes API error" });
    }

    const data = await response.json();

    console.log("🟡 Google Routes response:", JSON.stringify(data, null, 2));

    if (!data.routes?.length) {
      return res.status(400).json({ error: "No routes" });
    }

    res.json({
      polyline: data.routes[0].polyline.encodedPolyline,
    });
  } catch (err) {
    console.error("❌ Route failed:", err);
    res.status(500).json({ error: "Route failed" });
  }
};
