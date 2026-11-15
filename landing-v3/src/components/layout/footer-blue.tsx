"use client";
import React, { useState } from "react";

const FooterBlue = () => {
  const [emailMessage, setEmailMessage] = useState("");

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmailMessage(e.target.value);
  };

  return (
    <div className="relative bg-[#063E92] w-full h-[400px] p-10">
      {/* top white line */}
      <div className="absolute top-15 left-1/2 transform -translate-x-1/2 w-[90%] h-[1px] bg-[#0083FF]"></div>
      {/* bottom white line */}
      <div className="absolute bottom-15 left-1/2 transform -translate-x-1/2 w-[90%] h-[1px] bg-[#0083FF]"></div>
      {/* bottom text */}
      <div className="w-full absolute bottom-5 left-1/2 transform -translate-x-1/2 text-white text-md text-center">
        App Dev Club is a registered 501(c)(3) nonprofit organization
      </div>
      {/* back to top button */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className="flex absolute top-1 gap-1 right-1 font-bold text-white items-center p-3 rounded hover:bg-[#0083FF] cursor-pointer transition-colors duration-100 text-xs"
      >
        <img src="back-to-top.png" alt="" className="w-4 h-4" />
      </button>
      <div className="flex flex-col justify-center items-center w-full h-full gap-y-8">
        <a href="">
          <img src="adclogo2.png" alt="ADC Logo" className="w-65 h-18" />
        </a>

        <div className="flex gap-5 items-center">
          <a
            href="https://www.instagram.com/app_dev_club/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="igicon.svg" alt="Instagram" className="w-7" />
          </a>
          <a
            href="https://www.linkedin.com/company/app-dev-club/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="linkedinicon.svg" alt="LinkedIn" className="w-7" />
          </a>
          <a
            href="https://github.com/appdev-club"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="githubicon.svg" alt="GitHub" className="w-7" />
          </a>
          <a
            href="mailto:umdappdev@gmail.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="email-icon.svg" alt="Email" className="w-7" />
          </a>
          <a
            href="https://discord.com/invite/scSeVbTT7G"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="discord.svg" alt="Discord" className="w-7" />
          </a>
        </div>
        <div className="w-full flex justify-center">
          <div className="w-[80%] md:w-3/5 lg:w-2/5 relative w-[40%]">
            <input
              type="email"
              placeholder="Send us an Email!"
              value={emailMessage}
              onChange={handleEmailChange}
              className={`text-white border-1 border-white rounded-lg p-3 w-full bg-transparent placeholder-white pr-10 ${
                emailMessage.length > 0 ? "font-bold" : ""
              }`}
            />
            <a
              href={`mailto:umdappdev@gmail.com?subject=Information Request&body=${emailMessage}`}
            >
              <img
                src="sendicon.png"
                alt=""
                className="w-5 h-5 absolute right-3 top-1/2 transform -translate-y-1/2"
              />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FooterBlue;
