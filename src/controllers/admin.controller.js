const pool = require("../db");

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE;
}

function parsePageSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(size, MAX_PAGE_SIZE);
}

function parseText(value) {
  const text = String(value || "").trim();
  return text.length > 0 ? text : null;
}

function parseBooleanFilter(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function buildPagination(total, page, pageSize) {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: total > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

function numeric(row, field) {
  return Number(row?.[field] ?? 0);
}

exports.getOverview = async (_req, res) => {
  try {
    const [summaryResult, recentUsersResult, recentRidesResult, recentBookingsResult] =
      await Promise.all([
        pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM users) AS total_users,
             (SELECT COUNT(*)::int FROM users WHERE role = 'driver') AS total_drivers,
             (SELECT COUNT(*)::int FROM users WHERE role = 'passenger') AS total_passengers,
             (SELECT COUNT(*)::int FROM rides WHERE status IN ('active', 'pending', 'scheduled', 'full', 'started')) AS active_rides,
             (SELECT COUNT(*)::int FROM bookings WHERE COALESCE(status, 'pending') = 'pending') AS pending_bookings,
             (SELECT COUNT(*)::int FROM users WHERE created_at::date = CURRENT_DATE) AS today_users,
             (SELECT COUNT(*)::int FROM rides WHERE created_at::date = CURRENT_DATE) AS today_rides,
             (SELECT COUNT(*)::int FROM bookings WHERE created_at::date = CURRENT_DATE) AS today_bookings,
             (SELECT COALESCE(SUM(balance), 0)::bigint FROM users) AS total_balance,
             (SELECT COALESCE(SUM(locked_balance), 0)::bigint FROM users) AS total_locked_balance`
        ),
        pool.query(
          `SELECT id, name, phone, role, verification_status, created_at
             FROM users
            ORDER BY created_at DESC, id DESC
            LIMIT 8`
        ),
        pool.query(
          `SELECT
             r.id,
             r.status,
             r.start_location,
             r.end_location,
             r.ride_date,
             r.start_time,
             COALESCE(r.seats_total, 0) AS seats_total,
             COALESCE(r.seats_taken, 0) AS seats_taken,
             u.name AS driver_name
           FROM rides r
           LEFT JOIN users u ON u.id = r.user_id
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 8`
        ),
        pool.query(
          `SELECT
             b.id,
             COALESCE(b.seats_booked, 1) AS seats_booked,
             COALESCE(b.status, 'pending') AS status,
             COALESCE(b.attendance_status, 'unknown') AS attendance_status,
             b.created_at,
             passenger.name AS passenger_name,
             driver.name AS driver_name,
             r.id AS ride_id,
             r.end_location
           FROM bookings b
           LEFT JOIN users passenger ON passenger.id = b.user_id
           LEFT JOIN rides r ON r.id = b.ride_id
           LEFT JOIN users driver ON driver.id = r.user_id
           ORDER BY b.created_at DESC, b.id DESC
           LIMIT 8`
        ),
      ]);

    const summary = summaryResult.rows[0] || {};

    res.json({
      summary: {
        total_users: numeric(summary, "total_users"),
        total_drivers: numeric(summary, "total_drivers"),
        total_passengers: numeric(summary, "total_passengers"),
        active_rides: numeric(summary, "active_rides"),
        pending_bookings: numeric(summary, "pending_bookings"),
        today_users: numeric(summary, "today_users"),
        today_rides: numeric(summary, "today_rides"),
        today_bookings: numeric(summary, "today_bookings"),
        total_balance: numeric(summary, "total_balance"),
        total_locked_balance: numeric(summary, "total_locked_balance"),
      },
      recent: {
        users: recentUsersResult.rows,
        rides: recentRidesResult.rows,
        bookings: recentBookingsResult.rows,
      },
    });
  } catch (err) {
    console.error("admin overview error:", err);
    res.status(500).json({ message: "Failed to load overview" });
  }
};

exports.listUsers = async (req, res) => {
  const page = parsePage(req.query.page);
  const pageSize = parsePageSize(req.query.page_size);
  const offset = (page - 1) * pageSize;
  const search = parseText(req.query.search);
  const role = parseText(req.query.role);
  const verificationStatus = parseText(req.query.verification_status);
  const blocked = parseBooleanFilter(req.query.blocked);

  const filters = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    filters.push(
      `(u.name ILIKE $${index} OR u.phone ILIKE $${index} OR COALESCE(u.email, '') ILIKE $${index})`
    );
  }

  if (role) {
    params.push(role);
    filters.push(`u.role = $${params.length}`);
  }

  if (verificationStatus) {
    params.push(verificationStatus);
    filters.push(`u.verification_status = $${params.length}`);
  }

  if (blocked !== null) {
    params.push(blocked);
    filters.push(`COALESCE(u.is_blocked, FALSE) = $${params.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    params.push(pageSize, offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;

    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.phone,
         u.email,
         u.role,
         COALESCE(u.rating, 1) AS rating,
         COALESCE(u.balance, 0) AS balance,
         COALESCE(u.locked_balance, 0) AS locked_balance,
         COALESCE(u.email_verified, FALSE) AS email_verified,
         COALESCE(u.phone_verified, FALSE) AS phone_verified,
         COALESCE(u.identity_verified, FALSE) AS identity_verified,
         COALESCE(u.driver_license_verified, FALSE) AS driver_license_verified,
         COALESCE(u.driver_verified, FALSE) AS driver_verified,
         COALESCE(u.one_way_verified, FALSE) AS one_way_verified,
         COALESCE(u.is_blocked, FALSE) AS is_blocked,
         u.verification_status,
         u.last_login_at,
         u.created_at,
         COALESCE((
           SELECT BOOL_OR(v.vehicle_verified)
             FROM vehicles v
            WHERE v.user_id = u.id
         ), FALSE) AS vehicle_verified,
         COUNT(*) OVER() AS total_count
       FROM users u
       ${whereClause}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );

    const total = numeric(result.rows[0], "total_count");
    const items = result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      phone: row.phone,
      email: row.email,
      role: row.role,
      rating: Number(row.rating ?? 1),
      balance: numeric(row, "balance"),
      locked_balance: numeric(row, "locked_balance"),
      email_verified: Boolean(row.email_verified),
      phone_verified: Boolean(row.phone_verified),
      identity_verified: Boolean(row.identity_verified),
      driver_license_verified: Boolean(row.driver_license_verified),
      driver_verified: Boolean(row.driver_verified),
      one_way_verified: Boolean(row.one_way_verified),
      is_blocked: Boolean(row.is_blocked),
      verification_status: row.verification_status,
      vehicle_verified: Boolean(row.vehicle_verified),
      last_login_at: row.last_login_at,
      created_at: row.created_at,
    }));

    res.json({
      items,
      pagination: buildPagination(total, page, pageSize),
    });
  } catch (err) {
    console.error("admin listUsers error:", err);
    res.status(500).json({ message: "Failed to load users" });
  }
};

exports.listRides = async (req, res) => {
  const page = parsePage(req.query.page);
  const pageSize = parsePageSize(req.query.page_size);
  const offset = (page - 1) * pageSize;
  const search = parseText(req.query.search);
  const status = parseText(req.query.status);
  const rideDate = parseText(req.query.ride_date);

  const filters = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    filters.push(
      `(COALESCE(r.start_location, '') ILIKE $${index}
        OR COALESCE(r.end_location, '') ILIKE $${index}
        OR COALESCE(u.name, '') ILIKE $${index}
        OR COALESCE(v.plate_number, '') ILIKE $${index})`
    );
  }

  if (status) {
    params.push(status);
    filters.push(`COALESCE(r.status, 'active') = $${params.length}`);
  }

  if (rideDate) {
    params.push(rideDate);
    filters.push(`CAST(r.ride_date AS TEXT) = $${params.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    params.push(pageSize, offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;

    const result = await pool.query(
      `SELECT
         r.id,
         r.status,
         r.start_location,
         r.end_location,
         r.ride_date,
         r.start_time,
         COALESCE(r.price, 0) AS price,
         COALESCE(r.seats_total, 0) AS seats_total,
         COALESCE(r.seats_taken, 0) AS seats_taken,
         r.created_at,
         u.id AS driver_id,
         u.name AS driver_name,
         v.brand,
         v.model,
         v.color,
         v.plate_number,
         COUNT(*) OVER() AS total_count
       FROM rides r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       ${whereClause}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );

    const total = numeric(result.rows[0], "total_count");
    const items = result.rows.map((row) => ({
      id: Number(row.id),
      status: row.status,
      start_location: row.start_location,
      end_location: row.end_location,
      ride_date: row.ride_date,
      start_time: row.start_time,
      price: numeric(row, "price"),
      seats_total: numeric(row, "seats_total"),
      seats_taken: numeric(row, "seats_taken"),
      available_seats: Math.max(
        numeric(row, "seats_total") - numeric(row, "seats_taken"),
        0
      ),
      created_at: row.created_at,
      driver_id: row.driver_id ? Number(row.driver_id) : null,
      driver_name: row.driver_name,
      vehicle: [row.brand, row.model, row.color].filter(Boolean).join(" ").trim(),
      plate_number: row.plate_number,
    }));

    res.json({
      items,
      pagination: buildPagination(total, page, pageSize),
    });
  } catch (err) {
    console.error("admin listRides error:", err);
    res.status(500).json({ message: "Failed to load rides" });
  }
};

exports.listBookings = async (req, res) => {
  const page = parsePage(req.query.page);
  const pageSize = parsePageSize(req.query.page_size);
  const offset = (page - 1) * pageSize;
  const search = parseText(req.query.search);
  const status = parseText(req.query.status);
  const attendanceStatus = parseText(req.query.attendance_status);
  const rideId = Number(req.query.ride_id);
  const userId = Number(req.query.user_id);

  const filters = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    filters.push(
      `(COALESCE(passenger.name, '') ILIKE $${index}
        OR COALESCE(driver.name, '') ILIKE $${index}
        OR COALESCE(r.end_location, '') ILIKE $${index}
        OR CAST(b.id AS TEXT) ILIKE $${index})`
    );
  }

  if (status) {
    params.push(status);
    filters.push(`COALESCE(b.status, 'pending') = $${params.length}`);
  }

  if (attendanceStatus) {
    params.push(attendanceStatus);
    filters.push(`COALESCE(b.attendance_status, 'unknown') = $${params.length}`);
  }

  if (Number.isInteger(rideId) && rideId > 0) {
    params.push(rideId);
    filters.push(`b.ride_id = $${params.length}`);
  }

  if (Number.isInteger(userId) && userId > 0) {
    params.push(userId);
    filters.push(`b.user_id = $${params.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    params.push(pageSize, offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;

    const result = await pool.query(
      `SELECT
         b.id,
         b.ride_id,
         b.user_id,
         COALESCE(b.seats_booked, 1) AS seats_booked,
         COALESCE(b.status, 'pending') AS status,
         COALESCE(b.attendance_status, 'unknown') AS attendance_status,
         b.approved_at,
         b.rejected_at,
         b.created_at,
         passenger.name AS passenger_name,
         passenger.phone AS passenger_phone,
         driver.id AS driver_id,
         driver.name AS driver_name,
         r.end_location,
         r.ride_date,
         r.start_time,
         COUNT(*) OVER() AS total_count
       FROM bookings b
       LEFT JOIN users passenger ON passenger.id = b.user_id
       LEFT JOIN rides r ON r.id = b.ride_id
       LEFT JOIN users driver ON driver.id = r.user_id
       ${whereClause}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    );

    const total = numeric(result.rows[0], "total_count");
    const items = result.rows.map((row) => ({
      id: Number(row.id),
      ride_id: row.ride_id ? Number(row.ride_id) : null,
      user_id: row.user_id ? Number(row.user_id) : null,
      seats_booked: numeric(row, "seats_booked"),
      status: row.status,
      attendance_status: row.attendance_status,
      approved_at: row.approved_at,
      rejected_at: row.rejected_at,
      created_at: row.created_at,
      passenger_name: row.passenger_name,
      passenger_phone: row.passenger_phone,
      driver_id: row.driver_id ? Number(row.driver_id) : null,
      driver_name: row.driver_name,
      end_location: row.end_location,
      ride_date: row.ride_date,
      start_time: row.start_time,
    }));

    res.json({
      items,
      pagination: buildPagination(total, page, pageSize),
    });
  } catch (err) {
    console.error("admin listBookings error:", err);
    res.status(500).json({ message: "Failed to load bookings" });
  }
};
