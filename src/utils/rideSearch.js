const EARTH_RADIUS_METERS = 6371000;
const INTERCITY_MIN_DISTANCE_METERS = 50000;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineMeters(first, second) {
  const firstLat = toNumber(first?.lat ?? first?.latitude);
  const firstLng = toNumber(first?.lng ?? first?.longitude);
  const secondLat = toNumber(second?.lat ?? second?.latitude);
  const secondLng = toNumber(second?.lng ?? second?.longitude);

  if (
    firstLat === null ||
    firstLng === null ||
    secondLat === null ||
    secondLng === null
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const latDelta = toRadians(secondLat - firstLat);
  const lngDelta = toRadians(secondLng - firstLng);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(firstLat)) *
      Math.cos(toRadians(secondLat)) *
      Math.sin(lngDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodePolyline(encoded) {
  if (typeof encoded !== "string" || !encoded.trim()) {
    return [];
  }

  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push({
      latitude: lat / 1e5,
      longitude: lng / 1e5,
    });
  }

  return points;
}

function toCartesian(point, referenceLatitude) {
  const latitude = toNumber(point?.lat ?? point?.latitude);
  const longitude = toNumber(point?.lng ?? point?.longitude);

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    x: EARTH_RADIUS_METERS * toRadians(longitude) * Math.cos(toRadians(referenceLatitude)),
    y: EARTH_RADIUS_METERS * toRadians(latitude),
  };
}

function pointToSegmentDistanceMeters(point, segmentStart, segmentEnd) {
  const referenceLatitude =
    ((toNumber(segmentStart?.lat ?? segmentStart?.latitude) ?? 0) +
      (toNumber(segmentEnd?.lat ?? segmentEnd?.latitude) ?? 0)) /
    2;

  const pointXY = toCartesian(point, referenceLatitude);
  const startXY = toCartesian(segmentStart, referenceLatitude);
  const endXY = toCartesian(segmentEnd, referenceLatitude);

  if (!pointXY || !startXY || !endXY) {
    return Number.POSITIVE_INFINITY;
  }

  const deltaX = endXY.x - startXY.x;
  const deltaY = endXY.y - startXY.y;
  const segmentLengthSquared = deltaX ** 2 + deltaY ** 2;

  if (segmentLengthSquared === 0) {
    return Math.hypot(pointXY.x - startXY.x, pointXY.y - startXY.y);
  }

  const projection =
    ((pointXY.x - startXY.x) * deltaX + (pointXY.y - startXY.y) * deltaY) /
    segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));

  const closestX = startXY.x + clampedProjection * deltaX;
  const closestY = startXY.y + clampedProjection * deltaY;

  return Math.hypot(pointXY.x - closestX, pointXY.y - closestY);
}

function pointToPolylineDistanceMeters(point, encodedPolyline) {
  const coordinates = decodePolyline(encodedPolyline);

  if (coordinates.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  if (coordinates.length === 1) {
    return haversineMeters(point, coordinates[0]);
  }

  let minimumDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const distance = pointToSegmentDistanceMeters(
      point,
      coordinates[index],
      coordinates[index + 1]
    );

    if (distance < minimumDistance) {
      minimumDistance = distance;
    }
  }

  return minimumDistance;
}

function getRideScope(ride) {
  const tripDistance = haversineMeters(
    {
      lat: ride?.start_lat,
      lng: ride?.start_lng,
    },
    {
      lat: ride?.end_lat,
      lng: ride?.end_lng,
    }
  );

  if (!Number.isFinite(tripDistance)) {
    return "local";
  }

  return tripDistance >= INTERCITY_MIN_DISTANCE_METERS ? "intercity" : "local";
}

function getDestinationDistanceMeters(ride, destination) {
  const endPointDistance = haversineMeters(destination, {
    lat: ride?.end_lat,
    lng: ride?.end_lng,
  });
  const routeDistance = pointToPolylineDistanceMeters(destination, ride?.polyline);

  return Math.min(endPointDistance, routeDistance);
}

module.exports = {
  INTERCITY_MIN_DISTANCE_METERS,
  getDestinationDistanceMeters,
  getRideScope,
  haversineMeters,
};
