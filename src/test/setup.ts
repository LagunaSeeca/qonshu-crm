import "@testing-library/jest-dom/vitest";
import { config as loadDotenv } from "dotenv";

// Load .env so DATABASE_URL and DATABASE_URL_TEST are available in all tests
loadDotenv();
