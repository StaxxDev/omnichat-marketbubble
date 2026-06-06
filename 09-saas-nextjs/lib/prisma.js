// Prisma client singleton (survives Next.js dev hot-reload).
const { PrismaClient } = require("@prisma/client");

const g = globalThis;
const prisma = g.__omnichatPrisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__omnichatPrisma = prisma;

module.exports = { prisma };
