import { AddVideo } from "@/components/AddVideo";
import styles from "./add.module.css";

export default function AddPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Добавить видео</h1>
      <p className={styles.lede}>
        Вставьте ссылку на кулинарное видео с YouTube. Каждое блюдо из него станет рецептом — это займёт пару минут и около 3 центов.
      </p>
      <AddVideo />
    </div>
  );
}
