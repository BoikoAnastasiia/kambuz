import { Suspense } from "react";
import { AddVideo } from "@/components/AddVideo";
import { currentRole, signIn, signOut } from "@/auth";
import { adminEmails } from "@/lib/roles";
import styles from "./add.module.css";

async function Gate() {
  const { role, email } = await currentRole();
  if (role === "admin") {
    return (
      <>
        <AddVideo />
        <SignedInAs email={email} />
      </>
    );
  }
  if (!email) {
    return (
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/add" });
        }}
      >
        <p className={styles.note}>Добавлять видео может только администратор сайта.</p>
        <button className="btn">Войти через Google</button>
      </form>
    );
  }
  return (
    <>
      <p className={styles.note}>Добавлять видео может только администратор сайта, а у этого аккаунта таких прав нет.</p>
      {/* Says only whether the list is empty, never what is in it: tells "not configured" from "not you". */}
      {adminEmails().size === 0 && <p className={styles.account}>На сервере не задан список администраторов (ADMIN_EMAILS).</p>}
      <SignedInAs email={email} />
    </>
  );
}

function SignedInAs({ email }: { email: string | null }) {
  return (
    <form
      className={styles.account}
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      Вы вошли как {email} · <button className={styles.linkButton}>Выйти</button>
    </form>
  );
}

export default function AddPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Добавить видео</h1>
      <p className={styles.lede}>
        Вставьте ссылку на кулинарное видео с YouTube. Каждое блюдо из него станет рецептом — это займёт пару минут и около 3 центов.
      </p>
      <Suspense fallback={<p className="empty">Проверяем доступ…</p>}>
        <Gate />
      </Suspense>
    </div>
  );
}
