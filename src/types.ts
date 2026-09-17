export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'dead';

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  created_at: string;
  active: number;
}

export interface EventRow {
  id: string;
  payload: string;
  created_at: string;
}

export interface Delivery {
  id: string;
  event_id: string;
  webhook_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  updated_at: string;
}
