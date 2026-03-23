exports.computeRoute = async (req, res) => {
  try {
    const { start, end } = req.body;

    const startLat = Number(start?.lat);
    const startLng = Number(start?.lng);
    const endLat = Number(end?.lat);
    const endLng = Number(end?.lng);

    if (
      !Number.isFinite(startLat) ||
      !Number.isFinite(startLng) ||
      !Number.isFinite(endLat) ||
      !Number.isFinite(endLng)
    ) {
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
                latitude: startLat,
                longitude: startLng,
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: endLat,
                longitude: endLng,
              },
            },
          },
          travelMode: "DRIVE",
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("Google API error:", text);
      return res.status(500).json({ error: "Google Routes API error" });
    }

    const data = await response.json();

    if (!data.routes?.length) {
      return res.status(400).json({ error: "No routes" });
    }

    res.json({
      polyline: data.routes[0].polyline.encodedPolyline,
    });
  } catch (err) {
    console.error("Route failed:", err);
    res.status(500).json({ error: "Route failed" });
  }
};
