const GOOGLE_PLACES_BASE_URL = "https://places.googleapis.com/v1";
const UB_CENTER = {
  latitude: 47.9185,
  longitude: 106.9177,
};

function getGoogleMapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

function buildGoogleErrorMessage(payload, fallbackMessage) {
  const apiMessage =
    payload?.error?.message ||
    payload?.error?.status ||
    payload?.message ||
    "";

  return String(apiMessage || fallbackMessage).trim();
}

exports.autocompletePlaces = async (req, res) => {
  try {
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: "Google Maps API key is not configured" });
    }

    const input = String(req.body?.input || "").trim();
    const sessionToken = String(req.body?.sessionToken || "").trim();
    const originLat = Number(req.body?.origin?.lat);
    const originLng = Number(req.body?.origin?.lng);

    if (input.length < 2) {
      return res.json({ suggestions: [] });
    }

    const requestBody = {
      input,
      languageCode: "mn",
      regionCode: "mn",
      includedRegionCodes: ["mn"],
      locationBias: {
        circle: {
          center: UB_CENTER,
          radius: 30000,
        },
      },
      ...(sessionToken ? { sessionToken } : {}),
      ...(Number.isFinite(originLat) && Number.isFinite(originLng)
        ? {
            origin: {
              latitude: originLat,
              longitude: originLng,
            },
          }
        : {}),
    };

    const response = await fetch(`${GOOGLE_PLACES_BASE_URL}/places:autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.place,suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
      },
      body: JSON.stringify(requestBody),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = buildGoogleErrorMessage(payload, "Google Places autocomplete failed");
      console.error("Places autocomplete failed:", message);
      return res.status(500).json({ error: "Google Places autocomplete failed" });
    }

    const suggestions = Array.isArray(payload?.suggestions)
      ? payload.suggestions
          .map((item) => item?.placePrediction)
          .filter(Boolean)
          .map((prediction) => {
            const placeId =
              prediction.placeId ||
              String(prediction.place || "")
                .split("/")
                .pop();
            const title =
              prediction.structuredFormat?.mainText?.text ||
              prediction.text?.text ||
              "";
            const subtitle = prediction.structuredFormat?.secondaryText?.text || "";
            const description =
              prediction.text?.text ||
              [title, subtitle].filter(Boolean).join(", ");

            return {
              placeId,
              title,
              subtitle,
              description,
            };
          })
          .filter((item) => item.placeId && item.title)
      : [];

    return res.json({ suggestions: suggestions.slice(0, 5) });
  } catch (error) {
    console.error("Places autocomplete failed:", error);
    return res.status(500).json({ error: "Places autocomplete failed" });
  }
};

exports.getPlaceDetails = async (req, res) => {
  try {
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: "Google Maps API key is not configured" });
    }

    const placeId = String(req.params.placeId || "").trim();
    const sessionToken = String(req.query.sessionToken || "").trim();

    if (!placeId) {
      return res.status(400).json({ error: "Place ID is required" });
    }

    const query = new URLSearchParams({
      languageCode: "mn",
      regionCode: "mn",
      ...(sessionToken ? { sessionToken } : {}),
    });

    const response = await fetch(
      `${GOOGLE_PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}?${query.toString()}`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
        },
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = buildGoogleErrorMessage(payload, "Google Place details failed");
      console.error("Place details failed:", message);
      return res.status(500).json({ error: "Google Place details failed" });
    }

    const lat = Number(payload?.location?.latitude);
    const lng = Number(payload?.location?.longitude);
    const name = String(payload?.displayName?.text || "").trim();
    const address = String(payload?.formattedAddress || "").trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Place coordinates not found" });
    }

    return res.json({
      placeId: String(payload?.id || placeId),
      name: name || address,
      address,
      label: [name, address].filter(Boolean).join(" - ") || address || name,
      lat,
      lng,
    });
  } catch (error) {
    console.error("Place details failed:", error);
    return res.status(500).json({ error: "Place details failed" });
  }
};
