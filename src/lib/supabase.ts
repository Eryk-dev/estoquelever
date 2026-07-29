import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    // Mantém o heartbeat fora da thread principal para abas longas/em segundo
    // plano não perderem o websocket por throttling do navegador.
    worker: true,
  },
});

supabase.realtime.onHeartbeat((status) => {
  if (status === "disconnected") {
    supabase.realtime.connect();
  }
});
