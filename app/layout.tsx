export const metadata = {
  title: "Asana Shelf Sync",
  description: "Asana webhook -> Google Sheets lookup -> Asana custom field update",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
