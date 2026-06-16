import {
  ensureDemoAdvisorLogin,
  seedAdmin,
  seedDemoBlogPosts,
  seedDemoEvents,
  seedDemoVolunteers,
  seedDemoVolunteerParticipation,
  seedMayVictoryEvents,
  seedStaffAccounts,
} from "./db.js";
import { buildServer } from "./server.js";

const app = await buildServer();
seedAdmin();
ensureDemoAdvisorLogin();
seedStaffAccounts();
seedDemoEvents();
seedMayVictoryEvents();
seedDemoBlogPosts();
seedDemoVolunteers();
seedDemoVolunteerParticipation();

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
  const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Сервер: http://${urlHost}:${port}`);
} catch (err) {
  if (err && err.code === "EADDRINUSE") {
    console.error("");
    console.error(`Ошибка: порт ${port} уже занят (часто это предыдущий запуск сервера).`);
    console.error("");
    console.error("Варианты:");
    console.error(`  1) Другой порт:  PORT=8080 npm start`);
    console.error(`  2) Закрыть процесс на ${port}:  lsof -i :${port}   затем kill <PID>`);
    console.error("");
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
