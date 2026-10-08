import { AddVideo } from "@/components/AddVideo";
import styles from "./add.module.css";

export default function AddPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Add a video</h1>
      <p className={styles.lede}>
        Paste a YouTube cooking video. Every dish in it becomes a recipe — it takes a couple of minutes and about 3 cents.
      </p>
      <AddVideo />
    </div>
  );
}
