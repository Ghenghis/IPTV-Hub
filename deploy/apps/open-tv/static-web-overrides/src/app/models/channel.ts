import { MediaType } from "./mediaType";

export class Channel {
  id?: number;
  name?: string;
  group_id?: number;
  image?: string;
  url?: string;
  media_type?: MediaType;
  source_id?: number;
  favorite?: boolean;
  stream_id?: number;
  tv_archive?: boolean;
  hidden?: boolean;
  provider_vault?: boolean;
  provider_id?: string;
  provider_kind?: "live" | "movie";
  provider_group?: string;
}
