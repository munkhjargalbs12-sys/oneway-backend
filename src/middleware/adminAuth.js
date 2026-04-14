const jwt = require("jsonwebtoken");

module.exports = function adminAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ message: "Authorization header missing" });
  }

  const token = header.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Token missing" });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET
    );

    if (!decoded?.adminUserId) {
      return res.status(401).json({ message: "Invalid admin token" });
    }

    req.admin = {
      id: Number(decoded.adminUserId),
      role: decoded.role || "super_admin",
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};
