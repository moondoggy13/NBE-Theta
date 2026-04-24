export function BackgroundMesh() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10 bg-[#f8f9fa]">
      <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-yellow-200/60 rounded-full mix-blend-multiply filter blur-[120px] animate-blob" />
      <div className="absolute top-[20%] right-[-10%] w-[40vw] h-[40vw] bg-fuchsia-300/50 rounded-full mix-blend-multiply filter blur-[120px] animate-blob animation-delay-2000" />
      <div className="absolute bottom-[-20%] left-[20%] w-[60vw] h-[60vw] bg-cyan-200/50 rounded-full mix-blend-multiply filter blur-[120px] animate-blob animation-delay-4000" />
      <div className="absolute top-[40%] left-[40%] w-[30vw] h-[30vw] bg-pink-300/40 rounded-full mix-blend-multiply filter blur-[100px] animate-blob animation-delay-6000" />
    </div>
  );
}
