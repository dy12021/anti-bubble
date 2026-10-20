/** B 站接口的响应信封。code === 0 才算成功。 */
export interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface NavData {
  isLogin: boolean;
  mid: number;
  uname: string;
  wbi_img: { img_url: string; sub_url: string };
}

export interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  author: string;
  mid: number;
  duration: number;
  description: string;
  pic: string;
  pubdate: number;
  owner: { mid: number; name: string };
  stat: { view: number; danmaku: number; reply: number; favorite: number; like: number };
  tname?: string;
}

export interface HistoryItem {
  history: {
    bvid: string;
    title: string;
    author_name: string;
    mid: number;
    cover: string;
    duration: number;
    viewed_at: number;
    business: string;
    tname?: string;
  };
}

export interface FavoriteFolder {
  id: number;
  title: string;
  media_count: number;
}

export interface FavoriteItem {
  id: number;
  type: string;
  title: string;
  upper?: { mid: number; name: string };
  duration?: number;
  bvid?: string;
  cover?: string;
  intro?: string;
  attr?: number;
  ctime?: number;
}

export interface CommentItem {
  rpid: number;
  mid: number;
  ctime: number;
  like: number;
  rcount: number;
  content: { message: string };
  member: { mid: number; uname: string; level: number };
  reply_control?: { reply_main_content?: { message: string } };
}

export interface SearchItem {
  bvid: string;
  title: string;
  author: string;
  mid: number;
  duration: string;
  description: string;
  pubdate: number;
  pic: string;
}

export interface ConclusionData {
  model_result?: string;
  outline?: { part_id: number; start_time: number; part_title: string; content: string }[];
}
