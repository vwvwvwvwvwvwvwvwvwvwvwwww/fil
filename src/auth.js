import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

export function generateCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function createAccessToken(subjectEmail, userId, role) {
  const expiresInSec = config.accessTokenExpireMinutes * 60;
  return jwt.sign(
    { sub: subjectEmail, uid: userId, role },
    config.secretKey,
    { algorithm: config.jwtAlgorithm, expiresIn: expiresInSec }
  );
}

export function decodeToken(token) {
  return jwt.verify(token, config.secretKey, { algorithms: [config.jwtAlgorithm] });
}
