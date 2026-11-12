/**
 * Deterministic random data for the developer seed: the same seed number gives the same records.
 * Texts are realistic Turkish construction correspondence; nothing comes from customer data.
 */

/** mulberry32: small, fast, deterministic. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** k distinct items. */
  sample<T>(list: readonly T[], k: number): T[] {
    const copy = [...list];
    const out: T[] = [];
    while (out.length < k && copy.length) out.push(copy.splice(Math.floor(this.next() * copy.length), 1)[0]!);
    return out;
  }
}

/** Seed number from a tag (so "demo-1" always produces the same data). */
export function seedFromTag(tag: string): number {
  let h = 2166136261;
  for (const ch of tag) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const DEMO_COMPANIES: { name: string; code: string; role: string }[] = [
  { name: "Demo Yapı Yatırım (İdare)", code: "IDR", role: "İdare" },
  { name: "Demo İnşaat Taahhüt (Yüklenici)", code: "YUK", role: "Yüklenici" },
  { name: "Demo Proje Müşavirlik (Müşavir)", code: "MSV", role: "Müşavir" },
  { name: "Demo Mimarlık Tasarım (Tasarımcı)", code: "TSR", role: "Tasarımcı" },
  { name: "Demo Elektromekanik (Alt Yüklenici)", code: "ELK", role: "Alt Yüklenici" },
];

export const DEMO_PEOPLE: { name: string; companyCode: string; title: string }[] = [
  { name: "Ayşe Demir", companyCode: "IDR", title: "Proje Müdürü" },
  { name: "Mehmet Kaya", companyCode: "YUK", title: "Şantiye Şefi" },
  { name: "Elif Yıldız", companyCode: "YUK", title: "Doküman Kontrol" },
  { name: "Can Öztürk", companyCode: "MSV", title: "Kontrol Mühendisi" },
  { name: "Zeynep Arslan", companyCode: "TSR", title: "Mimar" },
  { name: "Burak Şahin", companyCode: "ELK", title: "Saha Mühendisi" },
];

export const LETTER_SUBJECTS = [
  "Hakediş ödemesi hakkında",
  "Şantiye iş güvenliği önlemleri",
  "Beton döküm programı",
  "Kalıp iskelesi denetimi",
  "Malzeme onayı talebi",
  "İş programı revizyonu",
  "Ek süre talebi",
  "Tasarım değişikliği bildirimi",
  "Kazı çalışmaları ve zemin raporu",
  "Saha teslim tutanağı",
  "Elektrik tesisatı keşif artışı",
  "Mekanik tesisat güzergâh değişikliği",
  "Yağmur suyu drenajı uygulama projesi",
  "Fore kazık test sonuçları",
  "Cephe kaplama numune onayı",
  "İskele ve geçici yapılar",
  "Çevre düzenlemesi revize projesi",
  "Asansör montaj programı",
  "Yangın algılama sistemi teslimi",
  "Haftalık ilerleme raporu",
];

export const LETTER_BODIES = [
  "İlgi yazı ile bildirilen hususlar incelenmiş olup gerekli düzeltmelerin yapılması rica olunur.",
  "Söz konusu çalışmaların iş programına uygun olarak tamamlanması hususunda bilgilerinizi rica ederiz.",
  "Ekte sunulan belgelerin incelenerek tarafımıza bilgi verilmesini arz ederiz.",
  "Sahada yapılan kontrolde tespit edilen eksikliklerin en kısa sürede giderilmesi gerekmektedir.",
  "Konu ile ilgili görüşlerinizin yazılı olarak bildirilmesini rica ederiz.",
];

export const RFI_QUESTIONS = [
  "B3 bodrum kat perde duvar donatı detayında bindirme boyu belirtilmemiş. Uygulanacak bindirme boyu nedir?",
  "Mimari ve statik projelerde kolon ölçüleri farklı görünüyor. Hangi ölçü esas alınacak?",
  "Çatı drenaj borularının güzergâhı mekanik projede gösterilmemiş. Önerilen güzergâh uygun mudur?",
  "Zemin etüt raporunda yeraltı suyu seviyesi belirtilmemiş. Su yalıtımı detayı nasıl olacak?",
  "Asma tavan kotu ile havalandırma kanalı çakışıyor. Hangi eleman revize edilecek?",
  "Yangın kapılarının dayanım sınıfı şartnamede iki farklı değerde. Hangisi geçerli?",
  "Cephe ankraj detayında kullanılacak dübel tipi belirtilmemiş. Onaylı ürün listesi var mı?",
  "Otopark rampası eğimi yönetmelik sınırında. Uygulama projesi revize edilecek mi?",
  "Elektrik pano odası boyutları ekipman listesine göre yetersiz görünüyor. Oda büyütülecek mi?",
  "Merdiven korkuluk yüksekliği detay paftasında 90 cm, şartnamede 110 cm. Hangisi uygulanacak?",
];

export const RFI_ANSWERS = [
  "Statik proje esas alınacaktır; revize pafta ekte gönderilmiştir.",
  "Önerilen güzergâh uygundur, uygulamaya devam edilebilir.",
  "Şartnamedeki değer geçerlidir; detay paftası revize edilecektir.",
  "Bindirme boyu 50Ø olarak uygulanacaktır.",
  "Konu tasarım ekibiyle değerlendirilmiş, revize detay bir hafta içinde iletilecektir.",
];

export const SUBMITTAL_ITEMS = [
  "C30/37 hazır beton karışım raporu",
  "S420 inşaat demiri sertifikası",
  "Bitümlü membran su yalıtımı",
  "Isı yalıtım levhası (XPS)",
  "Alüminyum doğrama sistemi",
  "Seramik yer karosu",
  "Yangın kapısı (EI60)",
  "Asansör kabin seçimi",
  "Klima santrali teknik föyü",
  "Elektrik ana dağıtım panosu",
  "Yangın algılama paneli",
  "Sıhhi tesisat armatürleri",
];

export const MEETING_TOPICS = [
  "Haftalık koordinasyon toplantısı",
  "İş güvenliği toplantısı",
  "Tasarım koordinasyon toplantısı",
  "Hakediş değerlendirme toplantısı",
  "Kalite kontrol toplantısı",
];

export const MEETING_ITEMS: { konu: string; karar: string }[] = [
  { konu: "Kalıp iskelesi", karar: "Revize iskele projesi sunulacak." },
  { konu: "Beton döküm takvimi", karar: "Döküm programı haftalık güncellenecek." },
  { konu: "Malzeme teslimatı", karar: "Gecikmeli malzemeler için tedarikçiyle görüşülecek." },
  { konu: "İş güvenliği", karar: "Korkuluk eksikleri iki gün içinde tamamlanacak." },
  { konu: "Tasarım revizyonu", karar: "Revize paftalar müşavire gönderilecek." },
  { konu: "Saha temizliği", karar: "Moloz döküm alanı yeniden düzenlenecek." },
];

export const ISSUE_TITLES = [
  "Kolon pas payı yetersiz",
  "Perde duvarda segregasyon",
  "Döşeme kotu hatalı",
  "Yalıtım bindirmesi eksik",
  "Kapı kasası şakülünde değil",
  "Kanal askı aralığı fazla",
  "Elektrik tavası çakışması",
  "Cephe ankrajı eksik",
  "İskele korkuluğu eksik",
  "Seramik derz aralığı düzensiz",
];

export const TRANSMITTAL_SUBJECTS = [
  "Mimari uygulama projeleri gönderimi",
  "Statik hesap raporu gönderimi",
  "Mekanik tesisat paftaları gönderimi",
  "Elektrik tek hat şemaları gönderimi",
];

/** YYYY-MM-DD of today plus n days (local time). */
export function dayOffset(n: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n, 12);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A Date n days before now (keeps the time of day, slightly jittered by the caller). */
export function daysAgo(n: number, from = new Date()): Date {
  return new Date(from.getTime() - n * 86_400_000);
}
