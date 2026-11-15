import { LeadershipMember, leadershipMembers } from "@/data/leadership";
import { prefixPath } from "@/lib/prefix";
import Image from "next/image";
import FadeSlideIn from "../ui/fade-slide-in";

const Leadership = () => {
  return (
    <section
      id="leadership"
      className="flex flex-col items-center justify-center w-full pt-28 gap-12 relative z-0"
    >
      <h3 className="relative z-10 bg-white px-6 text-3xl md:text-5xl font-bold text-subheader">
        Our Leadership
      </h3>
      <div className="flex flex-wrap justify-center gap-y-10 gap-x-5 max-w-7xl px-4">
        {leadershipMembers.map((member, index) => (
          <FadeSlideIn delay={index * 50} key={member.name}>
            <Member name={member.name} role={member.role} src={member.src} />
          </FadeSlideIn>
        ))}
      </div>
    </section>
  );
};

const Member = ({ name, role, src }: LeadershipMember) => {
  return (
    <div className="flex flex-col items-center md:w-56 w-36">
      {src ? (
        <Image
          src={prefixPath(src)}
          alt={`${name}'s photo`}
          title={name}
          draggable={false}
          loading="lazy"
          priority={false}
          width={160}
          height={160}
          className="rounded-full mb-2 md:w-40 md:h-40 w-28 h-28"
        />
      ) : (
        <div
          title={name}
          className="bg-gray-200 rounded-full mb-2 flex items-center justify-center md:w-40 md:h-40 w-28 h-28 text-center"
        />
      )}
      <h4 className="mt-2 md:text-lg text-base font-semibold text-center">
        {name}
      </h4>
      <p className="md:text-sm text-xs text-gray-600 text-center">{role}</p>
    </div>
  );
};

export default Leadership;
