import bcrypt from 'bcrypt';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { getDb } from '../db/index.js';

const SALT_ROUNDS = 10;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

function getJwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '7d';
}

export interface TokenPayload {
  userId: string;
  username: string;
}

// The read-only 📐 setup feed's token (GET /api/tv/feed, 2026-11-28), for the operator's own
// program on their Mac, which reads the setups with no browser open. Same secret as a login, but
// the payload is a scope alone, no user: verifyToken refuses any token that carries a scope, so it
// opens the feed and nothing else, and verifyFeedToken refuses a login token.
const FEED_SCOPE = 'tv_feed';
const FEED_EXPIRES_IN = '30d';

export const authService = {
  async createUser(username: string, password: string) {
    const db = getDb();
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db
      .insertInto('users')
      .values({
        username,
        password: hashedPassword,
        active: true,
      })
      .returning(['id', 'username', 'active', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();

    return result;
  },

  async findUserByUsername(username: string) {
    const db = getDb();
    return db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
  },

  async findUserById(id: string) {
    const db = getDb();
    return db
      .selectFrom('users')
      .select(['id', 'username', 'active', 'created_at', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirst();
  },

  async validatePassword(plainPassword: string, hashedPassword: string) {
    return bcrypt.compare(plainPassword, hashedPassword);
  },

  generateToken(payload: TokenPayload): string {
    const options: SignOptions = {
      expiresIn: getJwtExpiresIn() as SignOptions['expiresIn'],
    };
    return jwt.sign(payload, getJwtSecret(), options);
  },

  // A login check (authMiddleware, the dashboard's SSE stream): a token with a `scope` is not a
  // login, whatever the scope.
  verifyToken(token: string): TokenPayload {
    const payload = jwt.verify(token, getJwtSecret());
    if (typeof payload !== 'object' || payload === null || 'scope' in payload) throw new Error('Not a login token');
    return payload as TokenPayload;
  },

  generateFeedToken(): { token: string; expires_at: string } {
    const token = jwt.sign({ scope: FEED_SCOPE }, getJwtSecret(), { expiresIn: FEED_EXPIRES_IN });
    const { exp } = jwt.decode(token) as JwtPayload;
    return { token, expires_at: new Date((exp ?? 0) * 1000).toISOString() };
  },

  // Throws unless the signature is good, the token has not expired and its scope is the feed's.
  verifyFeedToken(token: string): void {
    const payload = jwt.verify(token, getJwtSecret());
    if (typeof payload !== 'object' || payload === null || payload.scope !== FEED_SCOPE) throw new Error('Not a feed token');
  },
};
