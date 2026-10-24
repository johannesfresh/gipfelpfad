// GipfelPfad Vorab-Seite – öffentliche Supabase-Verbindung.
// Der anon/Publishable Key ist für den Browser gedacht und darf öffentlich sein:
// Die Tabelle switch_survey erlaubt per RLS nur das Eintragen (siehe supabase/umfrage.sql).
window.GP_SURVEY_CONFIG = {
  SUPABASE_URL: "https://gejyhgpkynpgwajfteds.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlanloZ3BreW5wZ3dhamZ0ZWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzEzNjMsImV4cCI6MjA5NzIwNzM2M30.kT5G-QXuqRZz5Nrjq_EmQv-4UjoauF984tnSA6svL7I"
};
